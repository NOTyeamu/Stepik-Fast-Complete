using System;

class Program
{
    static void Main()
    {
        int n = int.Parse(Console.ReadLine());

        for (int i = 1; i <= n; i++)
        {
            if (i % 3 == 0)
            {
                continue;
            }

            Console.Write(i + " ");
        }

        Console.WriteLine();
    }
}