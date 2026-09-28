using System;

class Program
{
    static void Main()
    {
        int chislo = int.Parse(Console.ReadLine());

        for (int i = chislo; i >= 1; i--)
        {
            for (int j = i; j >= 1; j--)
            {
                Console.Write(j + " ");
            }
            Console.WriteLine();
        }
    }
}