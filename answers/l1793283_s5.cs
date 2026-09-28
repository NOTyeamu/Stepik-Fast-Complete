using System;

class Program
{
    static void Main()
    {
        int n = int.Parse(Console.ReadLine());
        int summa = 0;

        for (int i = 1; i <= n; i++)
        {
            if (i % 2 == 0)
            {
                summa = summa + i;
            }
        }

        Console.WriteLine(summa);
    }
}