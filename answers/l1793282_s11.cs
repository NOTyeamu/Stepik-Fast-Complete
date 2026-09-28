using System;

class Program
{
    static void Main()
    {
        int chislo = int.Parse(Console.ReadLine());

        for (int i = 0; i < chislo; i++)
        {
            for (int j = 0; j < chislo; j++)
            {
                if ((i + j) % 2 == 0)
                {
                    Console.Write("*");
                }
                else
                {
                    Console.Write("-");
                }
            }
            Console.WriteLine();
        }
    }
}